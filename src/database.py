import sqlite3

_conn = None
_cursor = None

class DatabaseHelper:


  @staticmethod
  def init():
    global _conn, _cursor
    if _conn is None:
      _conn = sqlite3.connect("file_embeddings.db")
      _cursor = _conn.cursor()
  
  @staticmethod
  def write(query, params = None):
    global _conn, _cursor
    if params:
      _cursor.execute(query, params)
    else:
      _cursor.execute(query)
    _conn.commit()

  @staticmethod
  def read(query):
    global _conn, _cursor
    _cursor.execute(query)
    rows = _cursor.fetchall()
    return rows

  @staticmethod
  def close():
    global _conn
    # Close SQLite connection
    _conn.close()
    _conn = None