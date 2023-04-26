import os
import sqlite3

_conn = None
_cursor = None

class DatabaseHelper:

  @staticmethod
  def init(db_folder):
    global _conn, _cursor
    if _conn is None:
      db_file_path = os.path.join(db_folder, "file_embeddings.db")
      _conn = sqlite3.connect(db_file_path)
      _cursor = _conn.cursor()

      # Create tables if not exists
      DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS embeddings (
                      id TEXT, date TEXT, file_name TEXT, section_number INTEGER, 
                      embedding TEXT)""")
      DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS excluded (
                    id TEXT, date TEXT, reason TEXT)""")
      DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS history (
                    id TEXT, date TEXT, query TEXT, query_embedding TEXT, results TEXT)""")
  
  @staticmethod
  def write(query, params = None):
    global _conn, _cursor
    if params:
      _cursor.execute(query, params)
    else:
      _cursor.execute(query)
    _conn.commit()

  @staticmethod
  def read(query, params = None):
    global _conn, _cursor
    if params:
      _cursor.execute(query, params)
    else:
      _cursor.execute(query)
    rows = _cursor.fetchall()
    return rows

  @staticmethod
  def close():
    global _conn
    # Close SQLite connection
    _conn.close()
    _conn = None

  @staticmethod
  def drop_table(table_name):
    DatabaseHelper.write(f"DROP TABLE {table_name}")