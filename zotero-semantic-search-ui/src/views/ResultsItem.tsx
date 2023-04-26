import * as React from 'react';
import { ISearchResult } from '../ResultsContext';
import { Disclosure, Transition } from '@headlessui/react';
import { ResultsItemPreview } from './ResultsItemPreview';

interface IResultsItemProps {
  folderId: string;
  result: ISearchResult
}

export const ResultsItem: React.FC<IResultsItemProps> = (props: IResultsItemProps) => (
  <div className="mb-2">
    <Disclosure>
      <Disclosure.Button className="flex w-full justify-between rounded-lg bg-purple-100 px-4 py-2 text-left text-sm font-medium text-purple-900 hover:bg-purple-200 focus:outline-none focus-visible:ring focus-visible:ring-purple-500 focus-visible:ring-opacity-75">
        {props.result?.file_name.replace('.pdf', '') || props.folderId}
      </Disclosure.Button>

      <Transition
        enter="transition duration-100 ease-out"
        enterFrom="transform scale-95 opacity-0"
        enterTo="transform scale-100 opacity-100"
        leave="transition duration-75 ease-out"
        leaveFrom="transform scale-100 opacity-100"
        leaveTo="transform scale-95 opacity-0"
      >
        <Disclosure.Panel className="px-4 pt-4 pb-2 text-sm text-gray-500">
          <ResultsItemPreview folderId={props.folderId} result={props.result} />
        </Disclosure.Panel>
      </Transition>
    </Disclosure>
  </div>
)
