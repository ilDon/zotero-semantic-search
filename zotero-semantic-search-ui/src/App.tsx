import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import { PickFolder } from './views/PickFolder';
import { Search } from './views/Search';
import { Results } from './views/Results';
import { ResultsProvider } from './ResultsContext';
import { AppRoute } from './modules/routing.const';

export const App: React.FC = () => {
  return (
    <ResultsProvider>
      <Router>
        <Routes>
          <Route path={AppRoute.pickFolder} element={<PickFolder />} />
          <Route path={AppRoute.search} element={<Search />} />
          <Route path={AppRoute.results} element={<Results />} />
          <Route path="*" element={<Navigate to={AppRoute.search} />} />
        </Routes>
      </Router>
    </ResultsProvider>
  );
};
