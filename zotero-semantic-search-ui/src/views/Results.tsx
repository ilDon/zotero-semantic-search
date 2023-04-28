import * as React from 'react';
import { useResults } from '../ResultsContext';
import { ResultsItem } from './ResultsItem';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Api } from '../modules/api';
import { AppRoute } from '../modules/routing.const';
import { usePdfText } from '../providers/pdf-text-provider';

export const Results: React.FC = () => {
  const { setQuery, setResults, query, results } = useResults();
  const { addIds } = usePdfText();

  const navigate = useNavigate();

  const id = useParams()?.id;
  
  React.useEffect(() => {
    const fetchResult = async () => {
      const response = await new Api().fetchHistoryElement(id!);
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

  
  React.useEffect(() => {
    setTimeout(() => {
      const allIds = [...sortedResult]
        .sort((a, b) => (a.status ?? 0) - (b.status ?? 0))
        .map((result) => result.folder_id)
        .filter((value, index, self) => self.indexOf(value) === index);
    
      addIds(allIds);
    }, 1000);
  }, [sortedResult, addIds]);


  const uniqueIds = React.useMemo(() => [...new Set(sortedResult.map((result) => result.folder_id))], [sortedResult]);

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
      <p className="text-sm text-gray-500 mb-8">Total results: {sortedResult.length} (in {uniqueIds.length} {uniqueIds.length === 1 ? 'file' : 'files'})</p>
      {sortedResult.map((result, index) => (
        <ResultsItem
          key={`${result.folder_id}-${result.section_number}`}
          folderId={result.folder_id}
          result={result}
          index={index}
          historyElementId={id}
        />
      ))}
    </div>
  );
};
