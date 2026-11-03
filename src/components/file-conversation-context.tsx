"use client";

import { createContext, useContext } from "react";

export const FileConversationContext = createContext<string | undefined>(undefined);
export const useFileConversation = () => useContext(FileConversationContext);
