import { Disclosure } from '@headlessui/react';
import { useResults } from '../ResultsContext';

// Assuming the results are passed in a prop, state, context, or local storage
interface Result {
  similarity: number;
  folderId: string;
  fileName: string;
  sectionNumber: number;
}

export const Results: React.FC = () => {
  const { results } = useResults();
  // Group the results by folderId
  const groupedResults = results.reduce((acc: { [key: string]: Result[] }, result) => {
    if (!acc[result.folderId]) {
      acc[result.folderId] = [];
    }
    acc[result.folderId].push(result);
    return acc;
  }, {});

  return (
    <div className="container mx-auto py-5">
      <h1 className="text-3xl mb-5">Results</h1>
      {Object.entries(groupedResults).map(([folderId, results]) => (
        <div key={folderId} className="mb-5">
          <h2 className="text-2xl mb-2">{folderId}</h2>
          {results.map((result) => (
            <Disclosure key={`${result.fileName}-${result.sectionNumber}`}>
              {({ open }: { open: boolean }) => (
                <>
                  <Disclosure.Button className="flex justify-between w-full px-4 py-2 text-sm font-medium text-left bg-gray-200 rounded-lg hover:bg-gray-300 focus:outline-none focus-visible:ring focus-visible:ring-blue-500 focus-visible:ring-opacity-75">
                    <span>{result.fileName}</span>
                    <span>{open ? '-' : '+'}</span>
                  </Disclosure.Button>
                  <Disclosure.Panel className="p-4 text-sm text-gray-500">
                    Section: {result.sectionNumber}, Similarity: {result.similarity.toFixed(4)}
                  </Disclosure.Panel>
                </>
              )}
            </Disclosure>
          ))}
        </div>
      ))}
    </div>
  );
};
