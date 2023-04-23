import { Transition, Dialog } from '@headlessui/react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import * as React from 'react'

interface ISidebarMobileContainerProps {
  sidebarOpen: boolean
  children: React.ReactNode
  setSidebarOpen: (value: boolean) => void
}

export const SidebarMobileContainer: React.FC<ISidebarMobileContainerProps> = (props: ISidebarMobileContainerProps) => (
  <Transition.Root show={props.sidebarOpen} as={React.Fragment}>
    <Dialog as="div" className="relative z-50 lg:hidden" onClose={props.setSidebarOpen}>
      <Transition.Child
        as={React.Fragment}
        enter="transition-opacity ease-linear duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-linear duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <div className="fixed inset-0 bg-gray-900/80" />
      </Transition.Child>

      <div className="fixed inset-0 flex">
        <Transition.Child
          as={React.Fragment}
          enter="transition ease-in-out duration-300 transform"
          enterFrom="-translate-x-full"
          enterTo="translate-x-0"
          leave="transition ease-in-out duration-300 transform"
          leaveFrom="translate-x-0"
          leaveTo="-translate-x-full"
        >
          <Dialog.Panel className="relative mr-16 flex w-full max-w-xs flex-1">
            <Transition.Child
              as={React.Fragment}
              enter="ease-in-out duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="ease-in-out duration-300"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="absolute left-full top-0 flex w-16 justify-center pt-5">
                <button type="button" className="-m-2.5 p-2.5" onClick={() => props.setSidebarOpen(false)}>
                  <span className="sr-only">Close sidebar</span>
                  <XMarkIcon className="h-6 w-6 text-white" aria-hidden="true" />
                </button>
              </div>
            </Transition.Child>
            {props.children}
          </Dialog.Panel>
        </Transition.Child>
      </div>
    </Dialog>
  </Transition.Root>
)