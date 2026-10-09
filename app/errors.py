class ApiError(Exception):
    """Raised by service-layer functions; main.py converts these to HTTPException."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
