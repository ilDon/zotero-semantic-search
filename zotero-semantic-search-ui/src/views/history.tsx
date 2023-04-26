import * as React from 'react';
import { useResults } from '../ResultsContext';
import { Api, IHistoryItem } from '../modules/api';
import { useNavigate } from 'react-router-dom';
import { Menu, Transition } from '@headlessui/react';
import { EllipsisVerticalIcon } from '@heroicons/react/24/outline';

export const History: React.FC = () => {
  const [histories, setHistories] = React.useState<Array<IHistoryItem>>([]);
  const { setQuery, setResults } = useResults();
  const navigate = useNavigate();

  React.useEffect(() => {
    const fetchHistory = async () => {
      const response = await Api.history();
      setHistories(response);
    };
    fetchHistory();
  }, []);

  const handleLoadHistory = (result: IHistoryItem) => {
    setQuery(result.query);
    setResults(result.results);
    navigate('/results');
  };

  const handleDeleteHistory = async (id: string) => {
    await Api.deleteHistoryElement(id);
    setHistories(histories.filter((history) => history.id !== id));
  };

  return (
    <div className="container mx-auto">
      <h1 className="text-3xl mb-5">History</h1>
      <ul className="divide-y divide-gray-100">
      {histories.map((history) => (
        <li key={history.id} className="flex items-center justify-between gap-x-6 py-5">
          <div className="min-w-0">
            <div className="flex items-start gap-x-3">
              <p className="text-sm font-semibold leading-6 text-gray-900">{history.id}</p>
            </div>
            <div className="mt-1 flex items-center gap-x-2 text-xs leading-5 text-gray-500">
              <p className="whitespace-nowrap">
                {history.query}
              </p>
            </div>
          </div>
          <div className="flex flex-none items-center gap-x-4">
            <button
              onClick={() => handleLoadHistory(history)}
              className="hidden rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 sm:block"
            >
              View
            </button>
            <Menu as="div" className="relative flex-none">
              <Menu.Button className="-m-2.5 block p-2.5 text-gray-500 hover:text-gray-900">
                <span className="sr-only">Open options</span>
                <EllipsisVerticalIcon className="h-5 w-5" aria-hidden="true" />
              </Menu.Button>
              <Transition
                as={React.Fragment}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Menu.Items className="absolute right-0 z-10 mt-2 w-32 origin-top-right rounded-md bg-white py-2 shadow-lg ring-1 ring-gray-900/5 focus:outline-none">
                  <Menu.Item>
                    {({ active }) => (
                      <button
                        onClick={() => handleDeleteHistory(history.id)}
                        className={`${active ? 'bg-gray-50' : ''} block px-3 py-1 text-sm leading-6 text-gray-900`}
                      >
                        Delete
                      </button>
                    )}
                  </Menu.Item>
                </Menu.Items>
              </Transition>
            </Menu>
          </div>
        </li>
      ))}
    </ul>
    </div>
  );
};
