# Clinic voice agent image. Cloudflare builds this with ./agent as the build context
# (see wrangler.jsonc), so every COPY path below is relative to the agent/ directory.
FROM --platform=linux/amd64 python:3.11.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=10000

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN python -m pip install -r requirements.txt

COPY main.py calcom.py supabase_config.py ./

# Run as an unprivileged user; the agent only needs outbound network access.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin agent
USER agent

EXPOSE 10000
CMD ["python", "main.py"]
