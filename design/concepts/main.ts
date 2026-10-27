import { mount } from "svelte";
import WorkspaceConcepts from "./WorkspaceConcepts.svelte";

const target = document.getElementById("concepts");

if (target !== null) mount(WorkspaceConcepts, { target });
