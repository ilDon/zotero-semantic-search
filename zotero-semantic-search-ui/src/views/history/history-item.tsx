import * as React from 'react'
import { Menu, Transition } from '@headlessui/react';
import { EllipsisVerticalIcon } from '@heroicons/react/24/outline';
import { AppRoute } from '../../modules/routing.const';
import { IHistoryItem } from '../../modules/api';
import { useNavigate } from 'react-router-dom';
import { Routing } from '../../modules/routing';
import { useResults } from '../results/results-provider';

interface IHistoryItemProps {
  history: IHistoryItem
  onDelete: (id: string) => void
}

export const HistoryItem: React.FC<IHistoryItemProps> = (props: IHistoryItemProps) => {
  const navigate = useNavigate();
  const { setQuery, setResults } = useResults();

  const handleHistoryItemClick = () => {
    setQuery(props.history.query);
    setResults(props.history.results);
    navigate(Routing.getRoute(AppRoute.results, { id: props.history.id }));
  };

  const toBeCompleted = React.useMemo(() => props.history.results.filter(result => !result.status).length, [props.history.results]);
  const badgeColor = !toBeCompleted ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800';
  return (
    <li className="flex items-center justify-between gap-x-6 py-5">
      <div className="min-w-0">
        <div className="flex items-center gap-x-3">
          <p className="text-sm font-semibold leading-6 text-gray-900">
            {props.history.date} <span className="text-xs text-gray-400">({props.history.id})</span>
          </p>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeColor}`}>
            {!toBeCompleted ? 'Completed' : `In progress (${props.history.results.length - toBeCompleted}/${props.history.results.length})`}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-x-2 text-xs leading-5 text-gray-500 cursor-pointer" onClick={handleHistoryItemClick}>
          <p>
            {props.history.query}
          </p>
        </div>
      </div>
      <div className="flex flex-none items-center gap-x-4">
        <button
          onClick={handleHistoryItemClick}
          className="rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 sm:block"
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
                    onClick={() => props.onDelete(props.history.id)}
                    className={`${active ? 'bg-gray-50' : ''} block w-full px-3 py-1 text-sm text-left leading-6 text-gray-900`}
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
  )
}