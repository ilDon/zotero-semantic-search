import * as React from 'react';
import { ISearchResult, Status, useResults } from '../ResultsContext';
import { Disclosure, Transition } from '@headlessui/react';
import { FileNameWithId } from '../components/file-name-with-id';
import { usePdfText } from '../providers/pdf-text-provider';
import { Api } from '../modules/api';

interface IResultsItemProps {
  folderId: string;
  result: ISearchResult
  index: number;
  historyElementId: string;
}

export const ResultsItem: React.FC<IResultsItemProps> = (props: IResultsItemProps) => {
  const [resultStatus, setResultStatus] = React.useState<ISearchResult['status']>(props.result.status || Status.todo);
  const { getSectionText } = usePdfText();
  const { updateResultStatus } = useResults();
  const sectionsText = getSectionText(props.folderId);
  
  const handleOpenFile = () => {
    new Api().openFile(props.folderId);
  };

  const handleSetStatus = (status: ISearchResult['status']) => {
    setResultStatus(status);
    updateResultStatus(props.index, status!, props.historyElementId);
  };

  const disclosureColors = React.useMemo(() => {
    switch (resultStatus) {
      case Status.todo:
        return 'bg-purple-100 text-purple-900 hover:bg-purple-200 focus-visible:ring-purple-500';
      case Status.analyzed:
        return 'bg-green-100 text-green-900 hover:bg-green-200 focus-visible:ring-green-500';
      case Status.irrelevant:
        return 'bg-gray-100 text-gray-900 hover:bg-gray-200 focus-visible:ring-gray-500';
    }
  }, [resultStatus]);

  return (
  <div className="mb-2">
    <Disclosure>
      <Disclosure.Button className={`flex w-full justify-between rounded-lg px-4 py-2 text-left text-sm font-medium focus:outline-none focus-visible:ring focus-visible:ring-opacity-75 ${disclosureColors}`}>
        <FileNameWithId
          fileName={props.result?.file_name}
          id={props.folderId}
        />
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
            {({ close }) => (
              <div className="overflow-hidden bg-white">
                <div className="">
                  <div className="flex space-x-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">
                        Score: {props.result.similarity}
                        <span className="ml-2 text-sm text-gray-500">
                          Section: {props.result.section_number} - {props.folderId}
                        </span>
                      </p>
                    </div>
                  </div>
                  {!!sectionsText?.[props.result.section_number] && (
                    <div className="pb-5 text-gray-500">
                      <p>{sectionsText[props.result.section_number]}</p>
                    </div>
                  )}
                  {!sectionsText?.[props.result.section_number] && (
                    <p className="my-4">Loading...</p>
                  )}
                  <div className="flex justify-between">
                    <button
                      type="button"
                      className="rounded-md bg-indigo-600 disabled:bg-indigo-500 px-2.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
                      onClick={handleOpenFile}
                    >
                      Open PDF
                    </button>
                    <select
                      name="status"
                      id="status"
                      className="mt-2 rounded-md border-0 py-1.5 pl-3 pr-10 text-gray-900 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-indigo-600 sm:text-sm sm:leading-6"
                      value={resultStatus}
                      onChange={(e) => {
                        handleSetStatus(parseInt(e.target.value));
                        close();
                      }}
                    >
                      <option value={Status.todo}>Todo</option>
                      <option value={Status.analyzed}>Analyzed</option>
                      <option value={Status.irrelevant}>Irrelevant</option>
                    </select>
                  </div>
                </div>
              </div>
          )}
        </Disclosure.Panel>
      </Transition>
    </Disclosure>
  </div>
)
}
