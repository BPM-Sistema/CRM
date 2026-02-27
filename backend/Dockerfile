# Dockerfile para Cloud Run
# Base image con soporte para sharp (native dependencies)
FROM node:18-slim

# Instalar dependencias del sistema para sharp
RUN apt-get update && apt-get install -y \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar package files primero (mejor cache de Docker)
COPY package*.json ./

# Instalar dependencias de producción
RUN npm ci --only=production

# Copiar código fuente
COPY . .

# Crear directorio de uploads (temporal, Cloud Run es efímero)
RUN mkdir -p /app/uploads /tmp

# Puerto (Cloud Run inyecta PORT automáticamente)
ENV PORT=8080
EXPOSE 8080

# Comando de inicio
CMD ["node", "index.js"]
