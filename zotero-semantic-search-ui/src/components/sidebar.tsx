import * as React from 'react';
import { AppRoute } from '../modules/routing.const';
import { MagnifyingGlassIcon, ClockIcon, ArchiveBoxXMarkIcon } from '@heroicons/react/24/outline';
import { useLocation, useNavigate } from 'react-router-dom'


function classNames(...classes: any) {
  return classes.filter(Boolean).join(' ')
}

export const Sidebar: React.FC = () => {
  const location = useLocation()
  const navigation = useNavigate()

  const navigationData = [
    { name: 'Search', destination: AppRoute.search, icon: MagnifyingGlassIcon, current: location.pathname === AppRoute.search || location.pathname.startsWith(AppRoute.results.replace(':id', '')) },
    { name: 'History', destination: AppRoute.history, icon: ClockIcon, current: location.pathname === AppRoute.history },
    { name: 'Excluded', destination: AppRoute.excluded, icon: ArchiveBoxXMarkIcon, current: location.pathname === AppRoute.excluded }
  ]

  return (
    <div className="flex grow flex-col gap-y-5 overflow-y-auto bg-gray-900 px-6">
      <div className="flex h-16 shrink-0 items-center text-gray-400">
        Zotero Semantic Search
      </div>
      <nav className="flex flex-1 flex-col">
        <ul className="flex flex-1 flex-col gap-y-7">
          <li>
            <ul className="-mx-2 space-y-1">
              {navigationData.map((item) => (
                <li key={item.name}>
                  <button
                    type="button"
                    onClick={() => navigation(item.destination)}
                    className={classNames(
                      item.current
                        ? 'bg-gray-800 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800',
                      'group flex gap-x-3 rounded-md p-2 text-sm leading-6 font-semibold w-full'
                    )}
                  >
                    <item.icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                    {item.name}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        </ul>
      </nav>
    </div>
  )
}
