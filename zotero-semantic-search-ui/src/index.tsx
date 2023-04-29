import * as React from 'react';
import ReactDOM from "react-dom/client";
import { App } from './app-router';

import './assets/styles/tailwind.css';

const element = document.getElementById("root");
const root = ReactDOM.createRoot(element!);
root.render(<App />);

