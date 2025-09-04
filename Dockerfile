# Stage 1: Build the React Frontend
FROM node:18-alpine AS frontend-builder

WORKDIR /app

# Copy the frontend package files
COPY package.json ./

# Install frontend dependencies
RUN npm install

# Copy all frontend source files
COPY . ./

# Build the React app for production
RUN npm run build

# ---
# Stage 2: Build the Node.js Backend and serve the Frontend
FROM node:18-alpine AS final-image

# Set working directory for the backend
WORKDIR /app

# Copy the backend package files
COPY package.json ./

# Install backend dependencies
RUN npm install

# Copy the built frontend from the previous stage
COPY --from=frontend-builder /app/build ./public

# Copy the backend source code
COPY . ./

# Expose the port the app runs on
EXPOSE 8000

# Start the application
CMD [ "node", "server.js" ]