import type {
  APILabelComponent,
  APITextInputComponent,
  ComponentType,
  TextInputStyle,
} from "discord-api-types/v10";
import type { StoredReview } from "../../core/review";
import { EDIT_HINT, LABEL, modalTitle, NEW_HINT } from "./copy";

const LABEL_TYPE = 18 as ComponentType.Label;
const TEXT_INPUT = 4 as ComponentType.TextInput;
const PARAGRAPH = 2 as TextInputStyle.Paragraph;

export function replyModal(review: StoredReview): {
  custom_id: string;
  title: string;
  components: [APILabelComponent];
} {
  const editing = review.replyText !== null;
  const input: APITextInputComponent = {
    type: TEXT_INPUT,
    custom_id: "reply-text",
    style: PARAGRAPH,
    min_length: 1,
    max_length: 350,
    required: true,
  };
  if (editing && review.replyText !== null) input.value = review.replyText;
  return {
    custom_id: `reply-modal:${review.id}`,
    title: modalTitle(review.author, review.rating),
    components: [
      {
        type: LABEL_TYPE,
        label: LABEL,
        description: editing ? EDIT_HINT : NEW_HINT,
        component: input,
      },
    ],
  };
}
