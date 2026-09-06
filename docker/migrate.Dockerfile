# The migration runner.
#
#   docker build -f docker/migrate.Dockerfile -t battle-cloud-migrate .
#
# Separate from the worker image, which is 474 MB and carries a compiled Rust extension
# and a 13.7 MB usage-stats file to run four ALTER statements. Migrations gate every
# deploy, so the image that runs them should pull in seconds and depend on nothing that
# can fail to build.

FROM python:3.12-slim-bookworm

WORKDIR /app

RUN pip install --no-cache-dir "psycopg[binary]"

# The runner and the migrations, and nothing else. Compose mounts ./db over this for
# development so a new migration does not need a rebuild; the copy is what makes the
# image self-contained in a deploy, where there is no source tree to mount.
COPY db /app/db

ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "/app/db/migrate.py"]
CMD ["up"]
