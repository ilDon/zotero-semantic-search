import * as React from 'react';
import { ExcludedAdd } from './excluded-add';
import { FileNameWithId } from '../../components/file-name-with-id';
import { IExcludedFolder, Api } from '../../modules/api';

export const Excluded: React.FC = () => {
  const [excluded, setExcluded] = React.useState<Array<IExcludedFolder> | null>(null);

  const fetchExcluded = async () => {
    const response = await new Api().getExcluded();
    setExcluded(response);
  };

  React.useEffect(() => {
    fetchExcluded();
  }, []);

  const handleDeleteExcluded = async (id: string) => {
    await new Api().deleteExcluded(id);
    setExcluded(excluded!.filter((excluded) => excluded.id !== id));
  };

  if (!excluded) {
    return (
      <div className="container mx-auto">
        <h1 className="text-3xl mb-5">Excluded</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="container mx-auto">
      <h1 className="text-3xl mb-5">Excluded</h1>
      <ExcludedAdd onAdd={fetchExcluded} />
      <ul className="divide-y divide-gray-100">
        {excluded.map((excluded) => (
          <li key={excluded.id} className="py-4 flex">
            <div className="ml-3">
              <FileNameWithId
                fileName={excluded.file_name}
                id={excluded.id}
              />
              <p className="text-sm text-gray-500">{excluded.reason}</p>
            </div>
            <div className="ml-auto pl-3">
              {excluded.reason !== 'encrypted' && excluded.reason !== 'no_text' && (
                <button
                  type="button"
                  className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm leading-4 font-medium rounded-md text-white bg-red-600 hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  onClick={() => handleDeleteExcluded(excluded.id)}
                >
                  Remove from excluded
                </button>
              )}
            </div>
          </li>
        ))}

      </ul> 
    </div>  
  );
};
