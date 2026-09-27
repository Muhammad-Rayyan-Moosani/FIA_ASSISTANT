from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Backend settings from environment variables (or ../.env)."""

    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    cors_origins: str = "http://localhost:3000"
    # Seconds between sampled seasons on the simulation stream, so crashes are watchable in the UI.
    sim_stream_delay_s: float = 0.4
    # Load the rulebook index and Hugging Face models in a background thread at start-up (off in tests).
    warm_up_models: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
