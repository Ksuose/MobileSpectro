FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1

# Install system deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl gcc libgl1 libglib2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main_v2:app --host 0.0.0.0 --port ${PORT:-8000}"]