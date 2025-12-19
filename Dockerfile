# Utiliser Node 20 slim
FROM node:20-slim

# Définir le dossier de travail
WORKDIR /app

# Copier les fichiers package
COPY package*.json ./

# Installer les dépendances
RUN npm install

# Copier le reste du projet
COPY . .

# Compiler TypeScript
RUN npx tsc

# Exposer le port de l'API
EXPOSE 4001

# Commande par défaut pour lancer l'API
CMD ["node", "dist/api.js"]
