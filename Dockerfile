# Stage 1: Build the React Frontend
FROM node:18-alpine AS frontend-builder

WORKDIR /app

# Copy all project files to the container
COPY . .

# Install dependencies and build the app
RUN npm install
RUN npm run build

# ---
# Stage 2: Build the Node.js Backend and serve the Frontend
FROM node:18-alpine AS final-image

# Copy all project files from the root of the repo
WORKDIR /app
COPY . .

# Copy the built frontend from the previous stage
COPY --from=frontend-builder /app/build ./public

# Install backend dependencies
RUN npm install

# Expose the port the app runs on
EXPOSE 8000

# Start the application
CMD [ "node", "server.js" ]