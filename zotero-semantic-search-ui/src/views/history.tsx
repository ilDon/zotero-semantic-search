import * as React from 'react';
import { Api, IHistoryItem } from '../modules/api';
import { HistoryItem } from './history-item';
import { useNavigate } from 'react-router-dom';
import { AppRoute } from '../modules/routing.const';
import { SearchFolder } from '../modules/search-folder';

export const History: React.FC = () => {
  const [histories, setHistories] = React.useState<Array<IHistoryItem> | null>(null);
  const searchFolder = SearchFolder.getSearchFolder();
  const navigate = useNavigate();
  
  React.useEffect(() => {
    const fetchHistory = async () => {
      const response = await new Api().history();
      setHistories(response);
    };
    fetchHistory();
  }, []);

  React.useEffect(() => {
    if (!searchFolder) {
      navigate(AppRoute.pickFolder);
    }
  }, [navigate, searchFolder]);

  const handleDeleteHistory = async (id: string) => {
    await new Api().deleteHistoryElement(id);
    setHistories(histories!.filter((history) => history.id !== id));
  };

  if (!histories) {
    return (
      <div className="container mx-auto">
        <h1 className="text-3xl mb-5">History</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="container mx-auto">
      <h1 className="text-3xl mb-5">History</h1>
      <ul className="divide-y divide-gray-100">
      {histories.map((history) => (
        <HistoryItem key={history.id} history={history} onDelete={handleDeleteHistory} />
      ))}
    </ul>
    </div>
  );
};
