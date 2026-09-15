# Generic container build — works for Fly.io, or any host that takes a
# Dockerfile. Builds one image; which process runs is picked at deploy time.
#
# Fly.io example (after `fly launch` picks this Dockerfile up):
#   fly deploy                     # runs the default CMD (the Actions API)
#   fly machine run . --entrypoint "npm run bot"   # a second machine for the bot
# Render and Railway don't need this file — they read render.yaml / Procfile
# instead — but it's here in case you deploy somewhere that only takes a
# container.
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "server"]
