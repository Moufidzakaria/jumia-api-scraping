# Web Scraping Jumia API

## Description
Ce projet est une API permettant de récupérer les informations des produits depuis le site **Jumia** via le **web scraping**. Les données sont stockées dans une base de données **MongoDB** en utilisant **Mongoose**, et elles sont accessibles via des endpoints **RESTful**.

L'objectif est de fournir un accès rapide et structuré aux informations des produits.

---

## Fonctionnalités
- Scraping automatique des produits depuis Jumia.
- Stockage des données dans MongoDB.
- Endpoint `/products` pour la recherche, le filtrage et la pagination.
- Protection par clé API (`x-rapidapi-key`).
- Limitation du nombre de requêtes (Rate limiting).
- Pagination et option `all` pour récupérer tous les produits.

---

## Installation

1. Cloner le projet :
```bash
git clone https://github.com/Moufidzakaria/api-scraping.git
cd api-scraping
