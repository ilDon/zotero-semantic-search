import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useResults } from '../ResultsContext';
import { SearchFolder } from '../modules/search-folder';
import { AppRoute } from '../modules/routing.const';
import { Api } from '../modules/api';

export const Search: React.FC = () => {
  const [query, setQueryOnState] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const searchFolder = SearchFolder.getSearchFolder();
  const navigate = useNavigate();
  const { setQuery, setResults } = useResults();

  React.useEffect(() => {
    const searchFolder = SearchFolder.getSearchFolder();
    if (!searchFolder) {
      navigate(AppRoute.pickFolder);
    }
  }, [navigate]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQueryOnState(e.target.value);
  };

  const handleFolderChange = () => {
    SearchFolder.deleteSearchFolder();
    navigate(AppRoute.pickFolder);
  }

  const handleSubmit = async () => {
    setLoading(true);
    try {
      setQuery(query)
      const response = await Api.query(query);
      setResults(response);
      navigate('/results');
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-5">
      <div className="flex items-center mb-2">
        <p className="text-gray-500">Search folder: </p>
        <p className="text-gray-900 font-semibold mx-2">{searchFolder}</p>
        <button
          type="button"
          className="rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          onClick={handleFolderChange}
        >
          Change
        </button>
      </div>
      <label htmlFor="about" className="block text-sm font-medium leading-6 text-gray-900">
        Enter your query
      </label>
      <div className="mt-2">
        <textarea
          id="about"
          name="about"
          rows={3}
          className="block w-full rounded-md border-0 p-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
          value={query}
          onChange={handleQueryChange}
        />
      </div>
      <div className="mt-2">
        <button
          type="button"
          className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>
    </div>
  );
};

