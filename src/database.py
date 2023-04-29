import os
import sqlite3

_conn = None
_cursor = None

class DatabaseHelper:

    def __init__(self, db_folder):
        db_file_path = os.path.join(db_folder, "file_embeddings.db")
        self._conn = sqlite3.connect(db_file_path)
        self._cursor = self._conn.cursor()

        # Create tables if not exists
        self.write("""CREATE TABLE IF NOT EXISTS embeddings (
                      id TEXT, date TEXT, file_name TEXT, section_number INTEGER, 
                      embedding TEXT)""")
        self.write("""CREATE TABLE IF NOT EXISTS excluded (
                    id TEXT, date TEXT, reason TEXT)""")
        self.write("""CREATE TABLE IF NOT EXISTS history (
                    id TEXT, date TEXT, query TEXT, query_embedding TEXT, results TEXT)""")

    def write(self, query, params = None):
        try:
            if params:
                self._cursor.execute(query, params)
            else:
                self._cursor.execute(query)
            self._conn.commit()
        except Exception as e:
            print(f"Error executing query: {query}")
            print(f"Params: {params}")
            print(f"Exception: {e}")

    def read(self, query, params = None):
        if params:
            self._cursor.execute(query, params)
        else:
            self._cursor.execute(query)
        rows = self._cursor.fetchall()
        return rows

    def close(self):
        # Close SQLite connection
        self._conn.close()
        self._conn = None

    def drop_table(self, table_name):
        self.write(f"DROP TABLE {table_name}")