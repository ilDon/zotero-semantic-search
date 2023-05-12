import * as React from 'react';
import { ISearchResult, Status, useResults } from './results-provider';

interface IResultsItemProps {
  resultStatus: ISearchResult['status'];
  result: ISearchResult
  index: number;
  historyElementId: string;
  close?: () => void;
  setResultStatus: (status: ISearchResult['status']) => void;
}

export const ResultsItemStatusChanger: React.FC<IResultsItemProps> = (props: IResultsItemProps) => {
  const { updateResultStatus } = useResults();
  
  const handleSetStatus = (status: ISearchResult['status']) => {
    props.setResultStatus(status);
    updateResultStatus(props.index, status!, props.historyElementId);
  };


  return (
    <select
      name="status"
      id="status"
      className="rounded-md border-0 py-1.5 pl-3 pr-10 text-gray-900 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-indigo-600 sm:text-sm sm:leading-6"
      value={props.resultStatus}
      onChange={(e) => {
        handleSetStatus(parseInt(e.target.value));
        props.close?.();
      }}
    >
      <option value={Status.todo}>Todo</option>
      <option value={Status.cited}>Cited</option>
      <option value={Status.irrelevant}>Irrelevant</option>
    </select>
)
}
