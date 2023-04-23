import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { PickFolder } from './views/PickFolder';
import { Query } from './views/Query';
import { Results } from './views/Results';
import { SearchFolderProvider } from './SearchFolderContext';
import { ResultsProvider } from './ResultsContext';

export const App: React.FC = () => {
  return (
    <SearchFolderProvider>
      <ResultsProvider>
        <Router>
          <Routes>
            <Route path="/pick-folder">
              <PickFolder />
            </Route>
            <Route path="/query">
              <Query />
            </Route>
            <Route path="/results">
              <Results />
            </Route>
          </Routes>
        </Router>
      </ResultsProvider>
    </SearchFolderProvider>
  );
};
