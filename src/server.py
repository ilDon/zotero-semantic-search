from flask import Flask
from flask_cors import CORS
from flask_socketio import SocketIO

app = Flask(__name__)
CORS(app) # Enable CORS for all routes
socketio = SocketIO(app, cors_allowed_origins="*")