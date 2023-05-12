import * as React from 'react';
import { useResults } from './results-provider';

interface IResultsItemProps {
  text: string
}

const PROMPT = `I am a university professor of law. I am writing a paper. The following is a section of my paper (SECTION), after that there is an excerpt from a paper that might be relevant in relation to what I wrote (EXCERPT). 
Please assess if the excerpt contains any concept that directly support the contents of SECTION. The concepts must be directly relevant.
If so, please reply by stating which part of the excerpt I should quote and where I should add the footnote in my SECTION. Skip prose.
If not, please reply: "no relevant text to quote".

SECTION:
[QUERY]

EXCERPT:
[TEXT]
`
export const ResultsItemGeneratePrompt: React.FC<IResultsItemProps> = (props: IResultsItemProps) => {
  const { query } = useResults();
  
  const handleCopyPrompt = () => {
    const prompt = PROMPT.replace('[QUERY]', query).replace('[TEXT]', props.text);
    navigator.clipboard.writeText(prompt);
  }

  return (
    <button
      type="button"
      className="ml-2 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
      onClick={handleCopyPrompt}
    >
      Copy prompt to clipboard
    </button>
)
}
