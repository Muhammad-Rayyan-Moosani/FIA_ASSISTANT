from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Backend settings from environment variables (or ../.env)."""

    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    cors_origins: str = "http://localhost:3000"
    # Seconds between sampled seasons on the simulation stream, so crashes are watchable in the UI.
    sim_stream_delay_s: float = 0.4

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
