import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import { PickFolder } from './views/pick-folder/pick-folder';
import { AppRoute } from './modules/routing.const';
import { useState } from 'react'
import { Bars3Icon } from '@heroicons/react/24/outline'
import { Sidebar } from './components/sidebar';
import { SidebarMobileContainer } from './components/sidebar-mobile-container';
import { PdfTextProvider } from './providers/pdf-text-provider';
import { Excluded } from './views/excluded/excluded';
import { Results } from './views/results/results';
import { History } from './views/history/history';
import { ResultsProvider } from './views/results/results-provider';
import { Search } from './views/search/search';

export const App: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <ResultsProvider>
      <PdfTextProvider>
        <Router>
          <div>
            <SidebarMobileContainer sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}>
              <Sidebar />
            </SidebarMobileContainer>

            <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
              <Sidebar />
            </div>

            <div className="sticky top-0 z-40 flex items-center gap-x-6 bg-gray-900 px-4 py-4 shadow-sm sm:px-6 lg:hidden">
              <button type="button" className="-m-2.5 p-2.5 text-gray-400 lg:hidden" onClick={() => setSidebarOpen(true)}>
                <span className="sr-only">Open sidebar</span>
                <Bars3Icon className="h-6 w-6" aria-hidden="true" />
              </button>
              <div className="flex-1 text-sm font-semibold leading-6 text-white">
                Zotero Semantic Search
              </div>
            </div>

            <main className="py-10 lg:pl-72">
              <div className="px-4 sm:px-6 lg:px-8">
                <Routes>
                  <Route path={AppRoute.pickFolder} element={<PickFolder />} />
                  <Route path={AppRoute.search} element={<Search />} />
                  <Route path={AppRoute.results} element={<Results />} />
                  <Route path={AppRoute.history} element={<History />} />
                  <Route path={AppRoute.excluded} element={<Excluded />} />
                  <Route path="*" element={<Navigate to={AppRoute.search} />} />
                </Routes>
              </div>
            </main>
          </div>
        </Router>
      </PdfTextProvider>
    </ResultsProvider>
  )
}