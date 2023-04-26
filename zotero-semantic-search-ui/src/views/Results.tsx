import * as React from 'react';
import { useResults } from '../ResultsContext';
import { ResultsItem } from './ResultsItem';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Api } from '../modules/api';
import { AppRoute } from '../modules/routing.const';

export const Results: React.FC = () => {
  const { setQuery, setResults, query, results } = useResults();
  const navigate = useNavigate();

  const id = useParams()?.id;
  
  React.useEffect(() => {
    const fetchResult = async () => {
      const response = await Api.fetchHistoryElement(id!);
      console.log('fetchResult ~ response:', response)
      if (response) {
        setQuery(response.query);
        setResults(response.results);
      } else {
        // navigate(AppRoute.search);
      }
    };

    if (id && !query && !results.length) {
      fetchResult();
    }
  }, [id, query, results, setQuery, setResults, navigate]);

  const sortedResult = React.useMemo(() => results.sort((a, b) => b.similarity - a.similarity), [results]);

  if (!id) {
    return (
      <Navigate to={AppRoute.search} />
    );
  }

  if (!query) {
    return (
      <div className="container mx-auto">
        <h1 className="text-3xl mb-5">Results</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto">
      <h1 className="text-3xl mb-5">Results</h1>
      <label className="text-sm text-gray-400">Query:</label>
      <p className="text-sm text-gray-500 mb-8">{query}</p>
      {sortedResult.map((result) => (
        <ResultsItem key={`${result.folder_id}-${result.section_number}`} folderId={result.folder_id} result={result} />
      ))}
    </div>
  );
};
