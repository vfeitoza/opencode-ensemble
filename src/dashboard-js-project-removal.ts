/** Project removal browser flow, kept separate from dashboard live rendering. */
export const DASHBOARD_JS_PROJECT_REMOVAL = `
let projectRemoval=null,projectRemovalBusy=false,projectRemovalGen=0,projectRemovalFocus=null;
async function projectRemovalRequest(route,body){
  const token=document.querySelector('meta[name="ensemble-write-token"]')?.content||'';
  const response=await fetch('api/projects/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Ensemble-Token':token},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Project removal failed. Refresh the preview to retry.');
  return data;
}
async function openProjectRemoval(projectId){
  if(projectRemovalBusy)return;
  closeDrawer();closeShortcuts();
  const gen=++projectRemovalGen;
  projectRemoval=null;projectRemovalFocus=document.activeElement;
  const dialog=document.getElementById('project-removal');
  document.getElementById('project-removal-name').textContent='Loading preview…';
  document.getElementById('project-removal-path').textContent='';
  document.getElementById('project-removal-counts').textContent='';
  document.getElementById('project-removal-error').textContent='';
  document.getElementById('project-removal-input').value='';
  document.getElementById('project-removal-input').disabled=true;
  document.getElementById('project-removal-confirm').disabled=true;
  if(!dialog.open)dialog.showModal();
  document.getElementById('project-removal-cancel').focus();
  try{
    const preview=await projectRemovalRequest('removal-preview',{projectId});
    if(gen!==projectRemovalGen||!dialog.open)return;
    projectRemoval=preview;
    document.getElementById('project-removal-name').textContent=preview.project.name;
    document.getElementById('project-removal-path').textContent=preview.project.path||preview.project.id;
    const c=preview.counts;
    document.getElementById('project-removal-counts').textContent=c.teams+' teams · '+c.members+' members · '+c.tasks+' tasks · '+c.messages+' messages · '+c.notifications+' notifications · '+c.spawnResources+' spawn records';
    document.getElementById('project-removal-error').textContent=preview.blockers.join(' ');
    document.getElementById('project-removal-input').disabled=!preview.token;
    if(preview.token)document.getElementById('project-removal-input').focus();
  }catch(error){if(gen===projectRemovalGen)document.getElementById('project-removal-error').textContent=error.message}
}
function updateProjectRemovalConfirm(){
  document.getElementById('project-removal-confirm').disabled=projectRemovalBusy||!projectRemoval?.token||document.getElementById('project-removal-input').value!==projectRemoval.project.name;
}
function closeProjectRemoval(){
  if(projectRemovalBusy)return;
  projectRemovalGen++;projectRemoval=null;
  document.getElementById('project-removal').close();
  if(projectRemovalFocus?.isConnected!==false)projectRemovalFocus?.focus();
}
async function confirmProjectRemoval(event){
  event.preventDefault();
  if(projectRemovalBusy||!projectRemoval?.token||document.getElementById('project-removal-input').value!==projectRemoval.project.name)return;
  projectRemovalBusy=true;
  updateProjectRemovalConfirm();
  document.getElementById('project-removal-cancel').disabled=true;
  document.getElementById('project-removal-error').textContent='Removing Ensemble history…';
  try{
    await projectRemovalRequest('remove',{projectId:projectRemoval.project.id,token:projectRemoval.token,name:document.getElementById('project-removal-input').value});
    selId=null;selProjectId=null;selCard=-1;expMsgs.clear();drawerActivity=null;drawerSession=null;
    projectRemovalBusy=false;closeProjectRemoval();
    document.getElementById('project-removal-status').textContent='Project removed from Ensemble. Files and OpenCode sessions were preserved.';
    await poll();
    document.getElementById('project-removal-status').focus();
  }catch(error){
    projectRemoval.token=null;
    document.getElementById('project-removal-error').textContent=error.message+' Close and reopen to get a fresh preview.';
  }finally{
    projectRemovalBusy=false;
    document.getElementById('project-removal-cancel').disabled=false;
    updateProjectRemovalConfirm();
  }
}
`;
