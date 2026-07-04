FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git patchelf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt \
    && find /usr/local/lib/python3.11/site-packages -name "*.so*" -exec sh -c 'patchelf --clear-execstack "$1" 2>/dev/null || true' _ {} \;

COPY app.py .

ENV HF_HOME=/models/huggingface
VOLUME ["/models"]

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
