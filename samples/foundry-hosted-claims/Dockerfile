FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CLAIMS_SCHEMA_DIR=/app/schemas \
    HOST=0.0.0.0 \
    PYTHON_ENVIRONMENT=Production
WORKDIR /app
COPY schemas/call-context.schema.json schemas/result.schema.json schemas/error.schema.json ./schemas/
COPY samples/foundry-hosted-claims/pyproject.toml ./agent/
COPY samples/foundry-hosted-claims/hosted_claims ./agent/hosted_claims/
RUN pip install --no-cache-dir ./agent && \
    useradd --create-home --uid 10001 claims && \
    mkdir -p /home/session
USER 0
ENV HOME=/home/session
EXPOSE 8088
CMD ["python", "-m", "hosted_claims.bootstrap"]
