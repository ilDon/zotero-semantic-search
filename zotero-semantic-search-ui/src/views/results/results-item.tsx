import * as React from 'react';
import { ISearchResult, Status } from './results-provider';
import { Disclosure, Transition } from '@headlessui/react';
import { FileNameWithId } from '../../components/file-name-with-id';
import { usePdfText } from '../../providers/pdf-text-provider';
import { Api } from '../../modules/api';
import { ResultsItemText } from './results-item-text';
import { ResultsItemStatusChanger } from './results-item-status-changer';

interface IResultsItemProps {
  folderId: string;
  result: ISearchResult
  index: number;
  historyElementId: string;
}

export const ResultsItem: React.FC<IResultsItemProps> = (props: IResultsItemProps) => {
  const [resultStatus, setResultStatus] = React.useState<ISearchResult['status']>(props.result.status || Status.todo);
  const { getSectionText } = usePdfText();
  const sectionsText = getSectionText(props.folderId);
  
  const handleOpenFile = () => {
    new Api().openFile(props.folderId);
  };

  const disclosureColors = React.useMemo(() => {
    switch (resultStatus) {
      case Status.todo:
        return 'bg-purple-100 text-purple-900 hover:bg-purple-200 focus-visible:ring-purple-500';
      case Status.cited:
        return 'bg-green-100 text-green-900 hover:bg-green-200 focus-visible:ring-green-500';
      case Status.irrelevant:
        return 'bg-gray-100 text-gray-900 hover:bg-gray-200 focus-visible:ring-gray-500';
    }
  }, [resultStatus]);

  return (
  <div className="mb-2">
    <Disclosure>
      <div className="flex w-full items-center justify-center">
        <Disclosure.Button className={`flex grow justify-between rounded-lg px-4 py-2 text-left text-sm font-medium focus:outline-none focus-visible:ring focus-visible:ring-opacity-75 mr-2 ${disclosureColors}`}>
          <FileNameWithId
            fileName={props.result?.file_name}
            id={props.folderId}
          />
        </Disclosure.Button>
        <ResultsItemStatusChanger
          resultStatus={resultStatus}
          result={props.result}
          index={props.index}
          historyElementId={props.historyElementId}
          setResultStatus={setResultStatus}
        />
      </div>

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
                      <FileNameWithId
                        fileName={props.result?.file_name}
                        id={props.folderId}
                      />
                      <p className="text-sm font-semibold text-gray-900">
                        Score: {props.result.similarity}
                        <span className="ml-2 text-sm text-gray-500">
                          Section: {props.result.section_number} - {props.folderId}
                        </span>
                      </p>
                    </div>
                  </div>
                  {!!sectionsText?.[props.result.section_number] && (
                    <ResultsItemText text={sectionsText[props.result.section_number]} />
                  )}
                  {!sectionsText?.[props.result.section_number] && (
                    <p className="my-4 text-gray-600">Loading...</p>
                  )}
                  <div className="flex justify-between">
                    <button
                      type="button"
                      className="rounded-md bg-indigo-600 disabled:bg-indigo-500 px-2.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
                      onClick={handleOpenFile}
                    >
                      Open PDF
                    </button>
                    <ResultsItemStatusChanger
                      resultStatus={resultStatus}
                      result={props.result}
                      index={props.index}
                      historyElementId={props.historyElementId}
                      setResultStatus={setResultStatus}
                      close={close}
                    />
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
