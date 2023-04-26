import * as React from 'react';
import { Api, IExcludedFolder } from '../modules/api';
import { Disclosure, Transition } from '@headlessui/react';

interface IExcludedAddProps {
  onAdd: () => void;
}

export const ExcludedAdd: React.FC<IExcludedAddProps> = (props) => {
  const [isRemoving, setIsRemoving] = React.useState<boolean>(false);
  const [folderId, setFolderId] = React.useState<string>('');
  const [reason, setReason] = React.useState<IExcludedFolder['reason']>('manual');
  
  const onCancel = () => {
    setFolderId('');
    setReason('manual');
  };
  
  const handleFormSubmit = async () => {
    setIsRemoving(true);
    await Api.addExcluded(folderId, reason);
    props.onAdd();
    setIsRemoving(false);
    onCancel();
  };


  return (
    <div className="mb-2">
      <Disclosure>
        <Disclosure.Button className="flex w-full justify-between rounded-lg bg-purple-100 px-4 py-2 text-left text-sm font-medium text-purple-900 hover:bg-purple-200 focus:outline-none focus-visible:ring focus-visible:ring-purple-500 focus-visible:ring-opacity-75">
          Add excluded folder
        </Disclosure.Button>

        <Transition
          enter="transition duration-100 ease-out"
          enterFrom="transform scale-95 opacity-0"
          enterTo="transform scale-100 opacity-100"
          leave="transition duration-75 ease-out"
          leaveFrom="transform scale-100 opacity-100"
          leaveTo="transform scale-95 opacity-0"
        >
          <Disclosure.Panel className="px-4 pt-4 pb-4 text-sm text-gray-500 border border-gray-900/10 mt-2 rounded-lg">
            <div className="">
              <div className="mt-10 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:flex md:items-center">
                <div className="md:grow">
                  <label htmlFor="folderId" className="block text-sm font-medium leading-6 text-gray-900">
                    Folder ID
                  </label>
                  <div className="mt-2">
                    <input
                      type="text"
                      name="folderId"
                      id="folderId"
                      value={folderId}
                      autoComplete="off"
                      onChange={(e) => setFolderId(e.target.value)}
                      className="block w-full rounded-md border-0 p-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
                      placeholder="Enter folder ID"
                    />
                  </div>
                </div>

                <div className="md:w-40">
                  <label htmlFor="mode" className="block text-sm font-medium leading-6 text-gray-900">
                    Reason
                  </label>
                  <div className="mt-2">
                    <select
                      id="mode"
                      name="mode"
                      value={reason}
                      onChange={(e) => setReason(e.target.value as IExcludedFolder['reason'])}
                      className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:max-w-xs sm:text-sm sm:leading-6"
                    >
                      <option selected={reason === 'encrypted'} value="encrypted">encrypted</option>
                      <option selected={reason === 'no_text'} value="no_text">no_text</option>
                      <option selected={reason === 'manual'} value="manual">manual</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-x-6">
              <button type="button" className="text-sm font-semibold leading-6 text-gray-900" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleFormSubmit}
                disabled={isRemoving}
                className="rounded-md bg-indigo-600 disabled:bg-indigo-500 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
              >
                Save
              </button>
            </div>
          </Disclosure.Panel>
        </Transition>
      </Disclosure>
    </div>
  )
}
