import subprocess, os, platform
from flask import request, jsonify
from datetime import date

from src.library_processor import LibraryProcessor
from src.library_finder import LibraryFinder
from src.pdf_parser import PdfParser
from src.database import DatabaseHelper
from src.server import socketio, app

@app.route('/scan', methods=['POST'])
def process_files():
    data = request.get_json()
    search_folder = data.get('search_folder')
    
    if not search_folder:
        return jsonify({"error": "search_folder parameter is required"}), 400
    
    processor = LibraryProcessor(search_folder=search_folder)
    processor.process_files()
    return jsonify({"status": "success", "message": "Files processed successfully"}), 200

@app.route('/query', methods=['POST'])
def query_files():
    data = request.get_json()
    search_folder = data.get('search_folder', 'test_files')
    query = data.get('query', '')
    
    if not search_folder or not query:
        return jsonify({"error": "search_folder and query parameters are required"}), 400
    
    finder = LibraryFinder(search_folder=search_folder)
    [query_hash, results] = finder.query_files(query)
    return jsonify({"status": "success", "results": results, "id": query_hash}), 200

@app.route('/pdf_sections', methods=['POST'])
def get_pdf_sections():
    data = request.get_json()
    search_folder = data.get('search_folder')
    folder_id = data.get('folder_id')

    if not search_folder or not folder_id:
        return jsonify({"error": "search_folder and folder_id parameters are required"}), 400

    pdf_file_path = PdfParser.get_pdf_file_path_from_folder_id(search_folder, folder_id)

    if not pdf_file_path:
        return jsonify({"error": f"No PDF file found in {folder_blob}"}), 404

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    db = DatabaseHelper(db_folder=db_folder)
    sections = PdfParser.parse_pdf_by_folder(db, pdf_file_path, folder_id)
    return jsonify({"status": "success", "results": sections})

@app.route('/open_file', methods=['POST'])
def open_file():
    data = request.get_json()
    search_folder = data.get('search_folder')
    folder_id = data.get('folder_id')
    
    if not search_folder or not folder_id:
        return jsonify({"error": "search_folder and folder_id parameters are required"}), 400
    
    pdf_file_path = PdfParser.get_pdf_file_path_from_folder_id(search_folder, folder_id)

    if not pdf_file_path:
        return jsonify({"error": f"No PDF file found in {folder_blob}"}), 404

    if platform.system() == 'Darwin':       # macOS
        subprocess.call(('open', pdf_file_path))
    elif platform.system() == 'Windows':    # Windows
        os.startfile(pdf_file_path)
    else:                                   # linux variants
        subprocess.call(('xdg-open', pdf_file_path))

    return jsonify({"status": "success", "message": "File opened successfully"}), 200


@app.route('/get_history', methods=['POST', 'OPTIONS'])
def get_history():
    
    if request.method == 'OPTIONS':
        return jsonify({"status": "success"}), 200
    
    data = request.get_json()
    search_folder = data.get('search_folder')
    
    if not search_folder:
        return jsonify({"error": "search_folder parameter is required"}), 400
    
    db_folder = os.path.dirname(os.path.abspath(search_folder))
    db = DatabaseHelper(db_folder=db_folder)
    rows = db.read("SELECT id, query, results, date FROM history")
    db.close()

    results = []
    for row in rows:
        result = {
            "id": row[0],
            "query": row[1],
            "results": row[2],
            "date": row[3]
        }
        results.append(result)

    return jsonify({"status": "success", "results": results}), 200

@app.route('/fetch_history_element', methods=['POST'])
def fetch_history_element():
    data = request.get_json()
    search_folder = data.get('search_folder')
    id = data.get('id')
    
    if not search_folder or not id:
        return jsonify({"error": "search_folder and id parameters are required"}), 400

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    db = DatabaseHelper(db_folder=db_folder)
    row = db.read("SELECT id, query, results, date FROM history WHERE id = ?", (id,))
    db.close()

    if not row:
        return jsonify({"error": f"No history item found with id {id}"}), 404
    first_row = row[0]
    result = {
        "id": first_row[0],
        "query": first_row[1],
        "results": first_row[2],
        "date": first_row[3]
    }

    return jsonify({"status": "success", "results": result}), 200

@app.route('/update_history_element', methods=['POST'])
def update_history_element():
    data = request.get_json()
    search_folder = data.get('search_folder')
    id = data.get('id')
    results = data.get('results')
    
    if not search_folder or not id or not results:
        return jsonify({"error": "search_folder, id, query and results parameters are required"}), 400

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    db = DatabaseHelper(db_folder=db_folder)
    db.write("UPDATE history SET results = ? WHERE id = ?", (results, id))
    db.close()
    return jsonify({"status": "success", "message": "History item updated successfully"}), 200


@app.route('/delete_history_element', methods=['POST'])
def delete_history():
    data = request.get_json()
    search_folder = data.get('search_folder')
    id = data.get('id')
    
    if not search_folder or not id:
        return jsonify({"error": "search_folder and id parameters are required"}), 400

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    db = DatabaseHelper(db_folder=db_folder)
    db.write("DELETE FROM history WHERE id = ?", (id,))
    db.close()
    return jsonify({"status": "success", "message": "History item deleted successfully"}), 200

@app.route('/get_excluded', methods=['POST', 'OPTIONS'])
def get_excluded():
      
      if request.method == 'OPTIONS':
          return jsonify({"status": "success"}), 200
      
      data = request.get_json()
      search_folder = data.get('search_folder')
      
      if not search_folder:
          return jsonify({"error": "search_folder parameter is required"}), 400
      
      db_folder = os.path.dirname(os.path.abspath(search_folder))
      db = DatabaseHelper(db_folder=db_folder)
      rows = db.read("SELECT id, reason, date FROM excluded ORDER BY date DESC")
      db.close()
  
      results = []
      for row in rows:
          result = {
              "id": row[0],
              "reason": row[1],
              "date": row[2],
              "file_name": PdfParser.get_pdf_file_path_from_folder_id(search_folder, row[0])
          }
          results.append(result)
  
      return jsonify({"status": "success", "results": results}), 200

@app.route('/get_excluded_ids', methods=['POST', 'OPTIONS'])
def get_excluded_ids():
      if request.method == 'OPTIONS':
          return jsonify({"status": "success"}), 200
      
      data = request.get_json()
      search_folder = data.get('search_folder')
      
      if not search_folder:
          return jsonify({"error": "search_folder parameter is required"}), 400
      
      db_folder = os.path.dirname(os.path.abspath(search_folder))
      db = DatabaseHelper(db_folder=db_folder)
      rows = db.read("SELECT id FROM excluded")
      db.close()
  
      results = []
      for row in rows:
          results.append(row[0])
  
      return jsonify({"status": "success", "results": results}), 200

@app.route('/add_excluded', methods=['POST'])
def add_excluded():
    data = request.get_json()
    search_folder = data.get('search_folder')
    id = data.get('folder_id')
    reason = data.get('reason')
    
    if not search_folder or not id or not reason:
        return jsonify({"error": "search_folder, id and reason parameters are required"}), 400

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    db = DatabaseHelper(db_folder=db_folder)
    today = date.today().strftime("%Y-%m-%d")
    db.write("INSERT INTO excluded (id, reason, date) VALUES (?, ?, ?)", (id, reason, today))
    db.write("DELETE FROM embeddings WHERE id = ?", (id,))
    db.close()
    return jsonify({"status": "success", "message": "Excluded item added successfully"}), 200

@app.route('/delete_excluded', methods=['POST'])
def delete_excluded():
    data = request.get_json()
    search_folder = data.get('search_folder')
    id = data.get('folder_id')
    
    if not search_folder or not id:
        return jsonify({"error": "search_folder and id parameters are required"}), 400

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    db = DatabaseHelper(db_folder=db_folder)
    db.write("DELETE FROM excluded WHERE id = ?", (id,))
    db.close()
    return jsonify({"status": "success", "message": "Excluded item deleted successfully"}), 200

if __name__ == '__main__':
    socketio.run(app, allow_unsafe_werkzeug=True)