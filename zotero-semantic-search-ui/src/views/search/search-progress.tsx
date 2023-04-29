import React, { useEffect, useState } from "react";
import { WebSocketHandler } from '../../modules/web-socket-handler';

interface ISearchProgressProps {
  isSearching: boolean;
}

export const SearchProgress: React.FC<ISearchProgressProps> = (props) => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const progressWebSocket = new WebSocketHandler(setProgress);

    return () => {
      progressWebSocket.close();
    };
  }, []);

  if (!props.isSearching) {
    return null;
  }

  return (
    <div className="flex items-center justify-center w-full mt-10">
      <h1>Progress: {progress}%</h1>
    </div>
  );
};