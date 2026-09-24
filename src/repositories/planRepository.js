const { getDatabase } = require('../db/connection');

class PlanRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  getById(id) {
    const stmt = this.db.prepare('SELECT * FROM plans WHERE id = ?');
    return stmt.get(id) || null;
  }

  getAll() {
    const stmt = this.db.prepare('SELECT * FROM plans');
    return stmt.all();
  }
}

module.exports = PlanRepository;
