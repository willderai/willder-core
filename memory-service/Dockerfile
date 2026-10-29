# Willder memory service (Python/FastAPI). Deploys to Railway/Render (CPU, no GPU).
FROM python:3.13-slim

WORKDIR /app

# System deps kept minimal; BGE/torch (added Jun 9) install as wheels.
COPY requirements.txt .
# Install the CPU-ONLY torch wheel FIRST so sentence-transformers doesn't pull the
# default CUDA build — this box is CPU-only (no GPU), and the CUDA stack
# (nvidia-*-cu13, cuda-toolkit, triton, cudnn/nccl/cublas…) is multi-GB of dead
# weight that bloats the image and slows cold starts. Pinning torch here means the
# requirements install below sees it already satisfied.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt

# Bake the embedder (BGE_MODEL, about 130 MB) into the image so a cold start loads it
# from disk instead of downloading it before the first query. Only the files prefetch
# imports are copied first, so this layer stays cached across ordinary code changes.
COPY app/__init__.py app/config.py app/lab_guard.py app/prefetch.py ./app/
RUN python -m app.prefetch

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
