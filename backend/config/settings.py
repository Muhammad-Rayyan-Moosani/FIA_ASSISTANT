from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Backend settings from environment variables (or ../.env)."""

    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    cors_origins: str = "http://localhost:3000"
    # Seconds between sampled seasons on the simulation stream, so crashes are watchable in the UI.
    sim_stream_delay_s: float = 0.4
    # Load the rulebook index and Hugging Face models in a background thread at start-up (off in tests).
    warm_up_models: bool = True
    # Steward agent (Claude). Without a key the rule engine's advisory is used and labelled as such.
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5"
    # Target for an advisory card; the rule-engine card shows instantly, Claude's replaces it when it lands.
    steward_latency_budget_ms: int = 2000
    steward_timeout_s: float = 12.0

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
