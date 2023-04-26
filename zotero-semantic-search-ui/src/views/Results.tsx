import * as React from 'react';
import { useResults } from '../ResultsContext';
import { ResultsItem } from './ResultsItem';

export const Results: React.FC = () => {
  const { query, results } = useResults();

  return (
    <div className="container mx-auto">
      <h1 className="text-3xl mb-5">Results</h1>
      <label className="text-sm text-gray-400">Query:</label>
      <p className="text-sm text-gray-500 mb-8">{query}</p>
      {results.map((result) => (
        <ResultsItem key={`${result.folder_id}-${result.section_number}`} folderId={result.folder_id} result={result} />
      ))}
    </div>
  );
};
