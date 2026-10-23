import {createRoot} from 'react-dom/client';
import App from './App';
import {ConsoleProvider} from './context';
import 'antd/dist/reset.css';
import './console.css';
createRoot(document.getElementById('root')!).render(<ConsoleProvider><App/></ConsoleProvider>);
