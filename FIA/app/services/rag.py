"""FIA rulebook retrieval: pdfplumber parsing -> article-aware chunks -> embeddings -> FAISS.

* Embeddings: ``sentence-transformers`` (default ``all-MiniLM-L6-v2``). If it is not
  installed, a deterministic hashed bag-of-n-grams embedder is used so the API and
  tests still work (lower recall; install the ML extras for production).
* Index: ``faiss.IndexFlatIP`` over L2-normalised vectors (= cosine). Falls back to
  a NumPy matrix product with identical semantics.
* Persistence: chunks + vectors are written to ``UMAP_RAG_INDEX_DIR`` and reloaded
  at start-up; the index is rebuilt automatically if the embedder changed.
"""
from __future__ import annotations

import io
import json
import logging
import re
import threading
import unicodedata
import zlib
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

from app.config import RagConfig

log = logging.getLogger(__name__)

try:  # pragma: no cover
    import faiss
except ImportError:  # pragma: no cover
    faiss = None


# ----------------------------------------------------------------------------- embedders
class Embedder(Protocol):
    name: str
    dim: int

    def encode(self, texts: list[str]) -> np.ndarray: ...


class SentenceTransformerEmbedder:  # pragma: no cover - heavy dependency
    def __init__(self, model_name: str) -> None:
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_name)
        self.name = f"sentence-transformers:{model_name}"
        get_dim = getattr(self.model, "get_embedding_dimension", None) or self.model.get_sentence_embedding_dimension
        self.dim = int(get_dim())

    def encode(self, texts: list[str]) -> np.ndarray:
        return self.model.encode(texts, batch_size=64, normalize_embeddings=True,
                                 convert_to_numpy=True).astype(np.float32)


_TOKEN = re.compile(r"[a-z0-9]+(?:\.[0-9]+)*")
_STOP = frozenset(
    "a an and are as at be by for from has have in is it its of on or shall that the this to was were will with "
    "any may must not no which who been being such than then there these those into during".split()
)


class HashingEmbedder:
    """Signed feature hashing of unigrams + bigrams with sublinear TF (no training needed)."""

    def __init__(self, dim: int = 2048) -> None:
        self.dim = dim
        self.name = f"hashing-ngram-{dim}"

    def _vec(self, text: str) -> np.ndarray:
        toks = [t for t in _TOKEN.findall(text.lower()) if t not in _STOP]
        feats = toks + [f"{a}_{b}" for a, b in zip(toks, toks[1:])]
        v = np.zeros(self.dim, np.float32)
        if not feats:
            return v
        h = np.fromiter((zlib.crc32(f.encode()) for f in feats), dtype=np.uint64, count=len(feats))
        idx = (h % self.dim).astype(np.int64)
        sign = np.where((h >> np.uint64(31)) & np.uint64(1), -1.0, 1.0).astype(np.float32)
        np.add.at(v, idx, sign)
        v = np.sign(v) * np.log1p(np.abs(v))
        n = np.linalg.norm(v)
        return v / n if n else v

    def encode(self, texts: list[str]) -> np.ndarray:
        return np.vstack([self._vec(t) for t in texts]) if texts else np.zeros((0, self.dim), np.float32)


def build_embedder(cfg: RagConfig) -> Embedder:
    if cfg.embedding_backend in ("auto", "sentence-transformers"):
        try:
            return SentenceTransformerEmbedder(cfg.embedding_model)
        except Exception as exc:  # ImportError or model download failure
            if cfg.embedding_backend == "sentence-transformers":
                raise
            log.warning("sentence-transformers unavailable (%s); using hashing embedder", exc)
    return HashingEmbedder()


# ----------------------------------------------------------------------------- chunking
@dataclass
class Chunk:
    document: str
    article: str | None
    page: int
    text: str
    heading: str | None = None  # enclosing article / section titles, used as retrieval context


# "ARTICLE 33" / "ARTICLE B1: ORGANISATION ..." and "33.3 Drivers must..." / "B2.4.1 The starting grid..."
_ARTICLE_HDR = re.compile(
    r"^\s*(?:ARTICLE|Article)\s+([A-Z]?\d{1,3}[A-Za-z]?)(?![.\d\w])"   # not "Article B2.3.4c ..." references
    r"|^\s*([A-Z]?\d{1,3}(?:\.\d{1,3}){1,3})\)?\s+(?=[A-Z(\"'a-z])"
)
_APPENDIX_HDR = re.compile(r"^\s*APPENDIX\s+([A-Z]?\d{1,3})\b")
_MAX_HEADING_CHARS = 120
_TOC_PAGE_NO = re.compile(r"\s+\d{1,3}$")
_TOC_LINE = re.compile(r"^(?:ARTICLE\s+)?[A-Z]?\d{1,3}(?:\.\d{1,3})*:?\s.*\s\d{1,3}$")
# FIA PDFs encode the "ff" ligature as a backtick (body font) or "=" (contents font):
# "o`icial" -> "official", "e`ort" -> "effort", "sta`" -> "staff", "O=icials" -> "Officials".
_LIGATURE_FF = re.compile(r"(?<=[A-Za-z])`|(?<=[A-Za-z])=(?=[a-z])")


def extract_pdf_pages(data: bytes) -> list[str]:
    import pdfplumber

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return [(p.extract_text() or "") for p in pdf.pages]


def clean_pages(pages: list[str], boilerplate_share: float = 0.3) -> list[str]:
    """Normalise PDF text: fix ligatures and drop running headers/footers.

    A line is boilerplate if (with digits masked, so "B2 1" == "B2 7") it appears on at
    least ``boilerplate_share`` of the pages — page headers, footers, copyright lines.
    """
    norm = [[_LIGATURE_FF.sub("ff", unicodedata.normalize("NFKC", ln)).strip() for ln in p.splitlines()] for p in pages]
    if len(pages) >= 5:
        counts: dict[str, int] = {}
        for lines in norm:
            for key in {re.sub(r"\d+", "#", ln) for ln in lines if ln}:
                counts[key] = counts.get(key, 0) + 1
        limit = boilerplate_share * len(pages)
        norm = [[ln for ln in lines if counts.get(re.sub(r"\d+", "#", ln), 0) < limit] for lines in norm]
    return ["\n".join(ln for ln in lines if ln) for lines in norm]


def _is_title(line: str) -> bool:
    """Short heading line ("B2.4 Race Qualifying Session") rather than a rule sentence."""
    text = _TOC_PAGE_NO.sub("", line)
    return len(text) <= 90 and not text.rstrip().endswith((".", ";", ":", ",")) and len(text.split()) <= 12


def _sort_key(number: str) -> tuple[str, tuple[int, ...]]:
    """"B2.10.3" -> ("B", (2, 10, 3)); "33A" -> ("", (33,))."""
    letter = number[0] if number[0].isalpha() else ""
    return letter, tuple(int(re.match(r"\d+", p).group()) for p in number[len(letter):].split("."))


def _is_toc_page(text: str) -> bool:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return len(lines) >= 5 and sum(bool(_TOC_LINE.match(ln)) for ln in lines) / len(lines) >= 0.5


def _ancestors(number: str) -> list[str]:
    parts = number.split(".")
    return [".".join(parts[:i]) for i in range(1, len(parts))]


def _window(body: str, start: int, max_chars: int) -> str:
    """``body[start:start + max_chars]`` moved to word boundaries so a chunk never starts or ends mid-word."""
    if start and body[start - 1] != " ":                    # began mid-word: skip to the next word
        sp = body.find(" ", start)
        if 0 <= sp - start < 40:
            start = sp + 1
    end = start + max_chars
    if end < len(body) and body[end] != " ":                # would end mid-word: back up to the last space
        sp = body.rfind(" ", start, end)
        if sp > start:
            end = sp
    return body[start:end].strip()


def chunk_pages(document: str, pages: list[str], max_chars: int, overlap: int) -> list[Chunk]:
    """Split on article numbers, then window long articles with overlap.

    Title-only lines ("ARTICLE B1: ORGANISATION…", "B2.4 Race Qualifying Session") are
    not indexed on their own; they become the ``heading`` breadcrumb of the numbered
    rules beneath them. Contents pages are skipped.

    Article numbers must increase through the document and keep the same section
    letter, so a wrapped line that happens to start with a reference ("B5.9 will be
    followed.") or a locally numbered list inside an article stays in the article body.
    """
    pages = clean_pages(pages)
    sections: list[tuple[str | None, int, list[str]]] = []
    titles: dict[str, str] = {}
    last: tuple[str, tuple[int, ...]] | None = None
    last_appendix: tuple[str, tuple[int, ...]] | None = None
    for pno, text in enumerate(pages, start=1):
        if _is_toc_page(text):
            continue
        for line in text.splitlines():
            am = _APPENDIX_HDR.match(line)
            if am and (last_appendix is None or _sort_key(am.group(1)) > last_appendix):
                last_appendix = _sort_key(am.group(1))
                label = f"Appendix {am.group(1)}"
                titles[label] = line[:_MAX_HEADING_CHARS]
                sections.append((label, pno, [line]))
                continue
            # Inside appendices, numbered lines are list items / quoted excerpts, not articles.
            m = None if last_appendix else _ARTICLE_HDR.match(line)
            if m:
                number = m.group(1) or m.group(2)
                key = _sort_key(number)
                if last is not None and (key[0] != last[0] or key[1] <= last[1]):
                    m = None  # out-of-sequence number: a reference or list item, not a new article
                else:
                    last = key
            if m:
                if _is_title(line):
                    titles[number] = _TOC_PAGE_NO.sub("", line)[:_MAX_HEADING_CHARS]
                sections.append((number, pno, [line]))
            elif sections:
                sections[-1][2].append(line)
            else:
                sections.append((None, pno, [line]))

    chunks: list[Chunk] = []
    step = max(max_chars - overlap, 1)
    for art, pno, lines in sections:
        if len(lines) == 1 and art is not None and _is_title(lines[0]):
            continue  # bare title or contents entry; carried as context by the rules beneath it
        if art and art.startswith("Appendix"):
            crumbs = [titles[art]]
        else:
            crumbs = [titles.get(a) for a in _ancestors(art)] if art else []
        head = " › ".join(c for c in crumbs if c) or None
        body = " ".join(lines)
        for start in range(0, max(len(body) - overlap, 1), step):
            piece = _window(body, start, max_chars)
            if len(piece) >= 20:
                chunks.append(Chunk(document, art, pno, piece, head))
    return chunks


# ----------------------------------------------------------------------------- index
class RulebookIndex:
    def __init__(self, cfg: RagConfig, embedder: Embedder | None = None) -> None:
        self.cfg = cfg
        self.embedder = embedder or build_embedder(cfg)
        self._lock = threading.Lock()
        self.chunks: list[Chunk] = []
        self._vectors = np.zeros((0, self.embedder.dim), np.float32)
        self._faiss = None

    @property
    def index_backend(self) -> str:
        return "faiss.IndexFlatIP" if faiss is not None else "numpy-inner-product"

    def _rebuild_faiss(self) -> None:
        if faiss is not None:
            self._faiss = faiss.IndexFlatIP(self.embedder.dim)
            if len(self._vectors):
                self._faiss.add(self._vectors)

    def remove_document(self, document: str) -> None:
        """Drop a document's chunks in memory (the on-disk index is untouched until ``save``)."""
        with self._lock:
            keep = [i for i, c in enumerate(self.chunks) if c.document != document]
            self.chunks = [self.chunks[i] for i in keep]
            self._vectors = self._vectors[keep]
            self._rebuild_faiss()

    def add_document(self, document: str, pages: list[str]) -> int:
        chunks = chunk_pages(document, pages, self.cfg.chunk_chars, self.cfg.chunk_overlap)
        if not chunks:
            return 0
        vecs = self.embedder.encode([self._embed_text(c) for c in chunks])
        with self._lock:
            # Re-ingesting a document replaces its previous chunks.
            keep = [i for i, c in enumerate(self.chunks) if c.document != document]
            self.chunks = [self.chunks[i] for i in keep] + chunks
            self._vectors = np.vstack([self._vectors[keep], vecs]).astype(np.float32)
            self._rebuild_faiss()
        return len(chunks)

    @staticmethod
    def _embed_text(c: Chunk) -> str:
        prefix = f"{c.heading} | " if c.heading and not c.text.startswith(c.heading) else ""
        return f"{prefix}Article {c.article}: {c.text}" if c.article else prefix + c.text

    def search(self, query: str, top_k: int, document: str | None = None) -> list[tuple[Chunk, float]]:
        q = self.embedder.encode([query]).astype(np.float32)
        with self._lock:
            n = len(self.chunks)
            if n == 0:
                return []
            k = n if document else min(top_k, n)
            if self._faiss is not None:
                scores, idx = self._faiss.search(q, k)
                pairs = list(zip(idx[0].tolist(), scores[0].tolist()))
            else:
                sims = self._vectors @ q[0]
                order = np.argsort(-sims)[:k]
                pairs = [(int(i), float(sims[i])) for i in order]
            hits = [(self.chunks[i], s) for i, s in pairs if i >= 0]
        if document:
            hits = [h for h in hits if h[0].document == document]
        return hits[:top_k]

    def stats(self) -> dict:
        with self._lock:
            docs = sorted({c.document for c in self.chunks})
            return {
                "documents": docs,
                "total_chunks": len(self.chunks),
                "dim": self.embedder.dim,
                "embedding_backend": self.embedder.name,
                "index_backend": self.index_backend,
            }

    # -------------------------------------------------------------- persistence
    def save(self) -> None:
        d = self.cfg.index_dir
        d.mkdir(parents=True, exist_ok=True)
        with self._lock:
            (d / "chunks.json").write_text(json.dumps([asdict(c) for c in self.chunks]), encoding="utf-8")
            np.save(d / "vectors.npy", self._vectors)
            (d / "meta.json").write_text(json.dumps({"embedder": self.embedder.name, "dim": self.embedder.dim}))

    def load(self) -> bool:
        d: Path = self.cfg.index_dir
        if not (d / "chunks.json").exists():
            return False
        chunks = [Chunk(**c) for c in json.loads((d / "chunks.json").read_text(encoding="utf-8"))]
        meta = json.loads((d / "meta.json").read_text()) if (d / "meta.json").exists() else {}
        if meta.get("embedder") == self.embedder.name and (d / "vectors.npy").exists():
            vecs = np.load(d / "vectors.npy").astype(np.float32)
        else:
            log.info("embedder changed (%s -> %s); re-embedding %d chunks",
                     meta.get("embedder"), self.embedder.name, len(chunks))
            vecs = self.embedder.encode([self._embed_text(c) for c in chunks]).astype(np.float32)
        with self._lock:
            self.chunks, self._vectors = chunks, vecs.reshape(-1, self.embedder.dim)
            self._rebuild_faiss()
        return True


# ----------------------------------------------------------------------------- folder ingestion
def pending_rulebooks(index: RulebookIndex, folder: Path) -> list[Path]:
    """PDFs in ``folder`` whose file stem is not yet a document in ``index``."""
    if not folder.is_dir():
        return []
    have = set(index.stats()["documents"])
    return [pdf for pdf in sorted(folder.glob("*.pdf")) if pdf.stem not in have]


def ingest_rulebook_dir(index: RulebookIndex, folder: Path) -> list[str]:
    """Index every PDF in ``folder`` that is not already in ``index`` (by file stem); persist if any added."""
    added = []
    for pdf in pending_rulebooks(index, folder):
        log.info("indexing rulebook %s", pdf.name)
        n = index.add_document(pdf.stem, extract_pdf_pages(pdf.read_bytes()))
        log.info("indexed %s: %d chunks", pdf.stem, n)
        added.append(pdf.stem)
    if added:
        index.save()
    return added
