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
          <Route path={AppRoute.pickFolder}>
            <PickFolder />
          </Route>
          <Route path={AppRoute.search}>
            <Search />
          </Route>
          <Route path={AppRoute.results}>
            <Results />
          </Route>
          <Route path="*">
            <Navigate to={AppRoute.search} />
          </Route>
        </Routes>
      </Router>
    </ResultsProvider>
  );
};
