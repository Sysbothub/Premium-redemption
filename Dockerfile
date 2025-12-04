# Use a stable, official Python base image
FROM python:3.11-slim

# Set environment variable for non-interactive frontend to prevent prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies needed for discord.py (opus for voice, libffi for PyNaCl)
# 'ffmpeg' is included as it's often needed for multimedia/audio handling.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    libopus-dev \
    libffi-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy the dependency file and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose the port used by Flask for the health check (3000 is the default)
ENV PORT=3000
EXPOSE ${PORT}

# Define the command to run the application when the container starts
CMD ["python", "redeem_bot.py"]
