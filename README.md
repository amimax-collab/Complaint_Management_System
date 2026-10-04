# Customer Complaint Management System

Web-based complaint management system (Node.js, Express, MySQL). Final year project.

## Requirements
- Node.js (current LTS) and npm
- MySQL 8.x (designed for 8.4 LTS; the automated tests in this archive were run on MySQL 8.0.46)

## Setup
1. `npm install`
2. Create the databases and accounts (run as a MySQL administrator). **Change the two passwords in `db/setup.sql` first.**
   `mysql -u root -p < db/setup.sql`
3. Create the tables: `mysql -u root -p complaint_mgmt_db < db/schema.sql` (and the same for `complaint_mgmt_test` if you will run the tests).
4. Copy `.env.example` to `.env` and set the database passwords and a long random `SESSION_SECRET`.
5. Load simulated data (optional): `npm run seed`  (500 customers, 3,000 complaints by default; every simulated account uses the password `Password123!`)
6. Start: `npm start`, then open http://localhost:3000

Simulated logins after seeding: `admin@example.org`, `supervisor1@example.org`, `officer1@example.org`, `customer1@example.org`.

## Tests and measurements
- `npm test` runs 177 automated tests with coverage against `complaint_mgmt_test` (it empties that database).
- `node scripts/indexbench.js` times the principal queries with and without their indexes.
- `node scripts/perf.js` measures response times over HTTP on the seeded database.
- `node scripts/scenarios.js` runs the 14 end-to-end scenarios reported in Chapter Four.

## Before real use
Use a persistent session store, TLS, rate limiting on login, a real SMTP account, and backups (see Chapter Four, Section 4.6).

## Live preview (GitHub Pages)
`docs/index.html` is a self-contained, responsive preview of the screens. It runs entirely in the browser against sample data and does **not** use the Node.js and MySQL backend. Once GitHub Pages is switched on for the `main` branch and `/docs` folder, it is served at `https://<your-username>.github.io/<repository-name>/`.

The full system (Node.js and MySQL) cannot run on GitHub Pages, which serves static files only.
