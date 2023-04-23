import * as React from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useResults } from '../ResultsContext';
import { SearchFolder } from '../modules/search-folder';
import { AppRoute } from '../modules/routing.const';

export const Search: React.FC = () => {
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { setResults } = useResults();

  React.useEffect(() => {
    const searchFolder = SearchFolder.getSearchFolder();
    if (!searchFolder) {
      navigate(AppRoute.pickFolder);
    }
  }, [navigate]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQuery(e.target.value);
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const searchFolder = SearchFolder.getSearchFolder();
      const response = await axios.post('/query-files', { query, search_folder: searchFolder });
      setResults(response.data);
      navigate('/results');
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-5">
      <h1 className="text-3xl mb-5">Enter your query</h1>
      <textarea
        className="w-full h-32 p-2 mb-5 border border-gray-300"
        value={query}
        onChange={handleQueryChange}
      />
      <button className="px-4 py-2 bg-blue-500 text-white" onClick={handleSubmit} disabled={loading}>
        {loading ? 'Searching...' : 'Search'}
      </button>
    </div>
  );
};

