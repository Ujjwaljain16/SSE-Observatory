# Stage 1: Build the Vite React Frontend
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies needed for Vite build)
RUN npm ci

# Copy the rest of the source code
COPY . .

# Build the frontend assets to /app/dist
RUN npm run build

# Stage 2: Setup the Production Node.js Backend
FROM node:20-alpine AS runner

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Copy package files
COPY package*.json ./

# Install only production dependencies (express, cors, helmet, @sentry/node)
RUN npm ci --omit=dev

# Copy the Express backend entry point
COPY server.js ./

# Copy the built Vite static assets from the builder stage
COPY --from=builder /app/dist ./dist

# Expose the API and static server port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
